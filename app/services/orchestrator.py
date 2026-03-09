import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from app.config import Settings
from app.database import RunRepository
from app.schemas import (
    AuditRunRequest,
    AuditRunResponse,
    ProductProfile,
    ProfileRequest,
    PromptAuditResult,
    PromptBank,
    PromptBankRequest,
    RunListItem,
    RunSummary,
)
from app.services.audit_runner import AuditRunner
from app.services.excel_exporter import ExcelExporter
from app.services.judge import JudgeService
from app.services.product_profiler import ProductProfiler
from app.services.prompt_bank import PromptBankService


class AuditOrchestrator:
    def __init__(
        self,
        settings: Settings,
        repository: RunRepository,
        profiler: ProductProfiler,
        prompt_bank_service: PromptBankService,
        audit_runner: AuditRunner,
        judge_service: JudgeService,
        excel_exporter: ExcelExporter,
    ):
        self.settings = settings
        self.repository = repository
        self.profiler = profiler
        self.prompt_bank_service = prompt_bank_service
        self.audit_runner = audit_runner
        self.judge_service = judge_service
        self.excel_exporter = excel_exporter

    def profile(self, request: ProfileRequest) -> ProductProfile:
        return self.profiler.build_profile(request.product_url, request.overrides)

    def generate_prompt_bank(self, request: PromptBankRequest) -> PromptBank:
        profile = self.profiler.build_profile(request.product_url, request.overrides)
        return self.prompt_bank_service.generate(profile, request.language, request.market)

    def run_audit(self, request: AuditRunRequest) -> AuditRunResponse:
        run_id = str(uuid4())
        created_at = datetime.now(UTC)
        audited_model = request.audited_model or self.audit_runner.default_model_for_provider(request.audited_provider)

        self.repository.create_run(
            {
                "run_id": run_id,
                "created_at": created_at.isoformat(),
                "status": "pending",
                "audited_provider": request.audited_provider,
                "audited_model": audited_model,
                "product_url": request.product_url,
                "language": request.language,
                "market": request.market,
                "enable_web_search": request.enable_web_search,
            }
        )

        try:
            self.repository.update_run(run_id, status="running")
            profile = self.profiler.build_profile(request.product_url, request.overrides)
            prompt_bank = self.prompt_bank_service.generate(profile, request.language, request.market)
            self.repository.update_run(
                run_id,
                product_profile_json=profile.model_dump(),
                prompt_bank_json=prompt_bank.model_dump(),
            )

            verify_urls = self.settings.verify_detected_urls if request.verify_detected_urls is None else request.verify_detected_urls
            results: list[PromptAuditResult] = []
            for prompt in prompt_bank.prompts:
                execution = self.audit_runner.execute_prompt(
                    prompt=prompt,
                    audited_provider=request.audited_provider,
                    audited_model=audited_model,
                    language=request.language,
                    market=request.market,
                    enable_web_search=request.enable_web_search,
                )
                judged = self.judge_service.judge(profile, execution, verify_detected_urls=verify_urls)
                merged = PromptAuditResult(
                    **execution.model_dump(),
                    **judged.model_dump(),
                )
                results.append(merged)
                self.repository.insert_prompt_result({"run_id": run_id, **merged.model_dump(mode="json")})

            summary = self._build_summary(results)
            response = AuditRunResponse(
                run_id=run_id,
                status="completed",
                created_at=created_at,
                audited_provider=request.audited_provider,
                audited_model=audited_model,
                product_profile=profile,
                prompt_bank=prompt_bank,
                results=results,
                summary=summary,
            )
            export_path = self.excel_exporter.export(response)
            response.export_path = export_path
            self.repository.update_run(
                run_id,
                status="completed",
                summary_json=summary.model_dump(),
                export_path=export_path,
            )
            return response
        except Exception as exc:
            self.repository.update_run(run_id, status="failed", error_message=str(exc))
            raise

    def list_runs(self, limit: int = 20) -> list[RunListItem]:
        items: list[RunListItem] = []
        for row in self.repository.list_runs(limit=limit):
            product_name = None
            if row.get("product_profile_json"):
                try:
                    product_profile = json.loads(row["product_profile_json"])
                    product_name = product_profile.get("product_name")
                except json.JSONDecodeError:
                    product_name = None
            items.append(
                RunListItem(
                    run_id=row["run_id"],
                    status=row["status"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                    audited_provider=row["audited_provider"],
                    audited_model=row["audited_model"],
                    product_name=product_name,
                    export_path=row.get("export_path"),
                )
            )
        return items

    def get_run(self, run_id: str) -> AuditRunResponse | None:
        row = self.repository.get_run(run_id)
        if not row:
            return None
        product_profile_json = json.loads(row["product_profile_json"]) if row.get("product_profile_json") else None
        prompt_bank_json = json.loads(row["prompt_bank_json"]) if row.get("prompt_bank_json") else None
        summary_json = json.loads(row["summary_json"]) if row.get("summary_json") else None
        results_json = self.repository.get_prompt_results(run_id)

        if not product_profile_json or not prompt_bank_json:
            return None

        results = [
            PromptAuditResult(
                prompt_id=item["prompt_id"],
                prompt_type=item["prompt_type"],
                prompt_text=item["prompt_text"],
                raw_response=item["raw_response"],
                detected_urls=json.loads(item["detected_urls_json"] or "[]"),
                cited_urls=json.loads(item["cited_urls_json"] or "[]"),
                model_provider=item["model_provider"],
                model_name=item["model_name"],
                latency_ms=item["latency_ms"],
                created_at=datetime.fromisoformat(item["created_at"]),
                product_hit=item["product_hit"],
                vendor_hit=item["vendor_hit"],
                exact_url_accuracy=item["exact_url_accuracy"],
                product_competitors=item["product_competitors"],
                rank=item["rank"],
                evidence_snippet=item.get("evidence_snippet"),
                judge_provider=item.get("judge_provider"),
                judge_model=item.get("judge_model"),
                judge_notes=item.get("judge_notes"),
            )
            for item in results_json
        ]

        return AuditRunResponse(
            run_id=row["run_id"],
            status=row["status"],
            created_at=datetime.fromisoformat(row["created_at"]),
            audited_provider=row["audited_provider"],
            audited_model=row["audited_model"],
            product_profile=ProductProfile(**product_profile_json),
            prompt_bank=PromptBank(**prompt_bank_json),
            results=results,
            summary=RunSummary(**summary_json) if summary_json else None,
            export_path=row.get("export_path"),
            error_message=row.get("error_message"),
        )

    def ensure_excel(self, run_id: str) -> str:
        run = self.get_run(run_id)
        if not run:
            raise RuntimeError("Run not found")
        if run.export_path and Path(run.export_path).exists():
            return run.export_path
        export_path = self.excel_exporter.export(run)
        self.repository.update_run(run_id, export_path=export_path)
        return export_path

    def _build_summary(self, results: list[PromptAuditResult]) -> RunSummary:
        total = len(results)
        if not total:
            return RunSummary(
                total_prompts=0,
                product_hit_rate=0,
                vendor_hit_rate=0,
                exact_url_accuracy_rate=0,
                average_competitors=0,
                average_rank_when_present=0,
            )
        product_hits = sum(result.product_hit for result in results)
        vendor_hits = sum(result.vendor_hit for result in results)
        exact_hits = sum(result.exact_url_accuracy for result in results)
        total_competitors = sum(result.product_competitors for result in results)
        ranks = [result.rank for result in results if result.rank > 0]
        return RunSummary(
            total_prompts=total,
            product_hit_rate=round(product_hits / total, 4),
            vendor_hit_rate=round(vendor_hits / total, 4),
            exact_url_accuracy_rate=round(exact_hits / total, 4),
            average_competitors=round(total_competitors / total, 4),
            average_rank_when_present=round(sum(ranks) / len(ranks), 4) if ranks else 0,
        )
