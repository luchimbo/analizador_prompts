from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from app.clients.openrouter import OpenRouterClient
from app.config import get_settings
from app.database import RunRepository
from app.schemas import AuditRunRequest, AuditRunResponse, ProductProfile, ProfileRequest, PromptBank, PromptBankRequest, RunListItem
from app.services.audit_runner import AuditRunner
from app.services.excel_exporter import ExcelExporter
from app.services.judge import JudgeService
from app.services.orchestrator import AuditOrchestrator
from app.services.product_profiler import ProductProfiler
from app.services.prompt_bank import PromptBankService
from app.utils import ensure_directory


settings = get_settings()
repository = RunRepository(settings.database_path)
openrouter_client = OpenRouterClient(settings)
profiler = ProductProfiler(settings)
prompt_bank_service = PromptBankService(settings, openrouter_client)
audit_runner = AuditRunner(settings, openrouter_client)
judge_service = JudgeService(settings, openrouter_client)
excel_exporter = ExcelExporter(settings)
orchestrator = AuditOrchestrator(
    settings=settings,
    repository=repository,
    profiler=profiler,
    prompt_bank_service=prompt_bank_service,
    audit_runner=audit_runner,
    judge_service=judge_service,
    excel_exporter=excel_exporter,
)

app = FastAPI(title=settings.app_name, version="0.1.0")


@app.on_event("startup")
def startup_event() -> None:
    ensure_directory(settings.artifacts_dir)
    repository.initialize()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "openrouter_configured": openrouter_client.is_configured,
        "default_openai_model": settings.openrouter_openai_audit_model,
        "default_gemini_model": settings.openrouter_gemini_audit_model,
        "default_kimi_model": settings.openrouter_kimi_audit_model,
    }


@app.post("/api/v1/profile", response_model=ProductProfile)
def profile_product(request: ProfileRequest) -> ProductProfile:
    try:
        return orchestrator.profile(request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/prompts", response_model=PromptBank)
def generate_prompts(request: PromptBankRequest) -> PromptBank:
    try:
        return orchestrator.generate_prompt_bank(request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/runs", response_model=AuditRunResponse)
def create_run(request: AuditRunRequest) -> AuditRunResponse:
    try:
        return orchestrator.run_audit(request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/v1/runs", response_model=list[RunListItem])
def list_runs(limit: int = 20) -> list[RunListItem]:
    return orchestrator.list_runs(limit=limit)


@app.get("/api/v1/runs/{run_id}", response_model=AuditRunResponse)
def get_run(run_id: str) -> AuditRunResponse:
    run = orchestrator.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@app.get("/api/v1/runs/{run_id}/excel")
def download_excel(run_id: str):
    try:
        path = orchestrator.ensure_excel(run_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(path=path, filename=f"{run_id}.xlsx", media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
