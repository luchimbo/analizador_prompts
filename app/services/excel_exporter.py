from pathlib import Path

from openpyxl import Workbook

from app.config import Settings
from app.schemas import AuditRunResponse
from app.utils import ensure_directory


class ExcelExporter:
    def __init__(self, settings: Settings):
        self.settings = settings

    def export(self, run: AuditRunResponse) -> str:
        export_dir = ensure_directory(Path(self.settings.artifacts_dir) / "exports")
        export_path = export_dir / f"{run.run_id}.xlsx"

        workbook = Workbook()
        detail_sheet = workbook.active
        detail_sheet.title = "Prompt Detail"
        detail_sheet.append(
            [
                "Prompt_ID",
                "Prompt_Type",
                "Prompt",
                "Raw_Response",
                "Product_Hit",
                "Vendor_Hit",
                "Exact_URL_Accuracy",
                "Product_Competitors",
                "Rank",
                "Detected_URLs",
                "Evidence_Snippet",
                "Model_Audited",
                "Timestamp",
            ]
        )
        for result in run.results:
            detail_sheet.append(
                [
                    result.prompt_id,
                    result.prompt_type,
                    result.prompt_text,
                    result.raw_response,
                    result.product_hit,
                    result.vendor_hit,
                    result.exact_url_accuracy,
                    result.product_competitors,
                    result.rank,
                    "\n".join(result.detected_urls),
                    result.evidence_snippet,
                    f"{result.model_provider}:{result.model_name}",
                    result.created_at.isoformat(),
                ]
            )

        summary_sheet = workbook.create_sheet(title="Summary")
        summary_sheet.append(["Run_ID", run.run_id])
        summary_sheet.append(["Status", run.status])
        summary_sheet.append(["Product", run.product_profile.product_name])
        summary_sheet.append(["Brand", run.product_profile.brand_name or ""])
        summary_sheet.append(["Store", run.product_profile.store_name or ""])
        summary_sheet.append(["Canonical_URL", run.product_profile.canonical_url])
        summary_sheet.append(["Audited_Model", f"{run.audited_provider}:{run.audited_model}"])
        if run.summary:
            summary_sheet.append(["Total_Prompts", run.summary.total_prompts])
            summary_sheet.append(["Product_Hit_Rate", run.summary.product_hit_rate])
            summary_sheet.append(["Vendor_Hit_Rate", run.summary.vendor_hit_rate])
            summary_sheet.append(["Exact_URL_Accuracy_Rate", run.summary.exact_url_accuracy_rate])
            summary_sheet.append(["Average_Competitors", run.summary.average_competitors])
            summary_sheet.append(["Average_Rank_When_Present", run.summary.average_rank_when_present])

        workbook.save(export_path)
        return str(export_path)
