"""Part 04 -- the tool layer.

Tools are registered once at startup and reached only through the gateway.
Importing a tool module elsewhere would create a second call path that skips
the policy check and the audit record, so nothing else does.
"""

from __future__ import annotations

from app.tools.gateway import gateway


def register_default_tools() -> None:
    """Install the MVP tool set, in the priority order the spec gives."""
    from app.tools.filesystem import FileListTool, FileReadTool, FileWriteTool
    from app.tools.generators.docx import DocxGenerateTool
    from app.tools.generators.pptx import PptxGenerateTool
    from app.tools.generators.xlsx import XlsxGenerateTool
    from app.tools.knowledge import KnowledgeSearchTool, OcrExtractTool
    from app.tools.python import PythonExecuteTool

    for tool in (
        KnowledgeSearchTool(),
        FileReadTool(),
        FileWriteTool(),
        FileListTool(),
        OcrExtractTool(),
        PythonExecuteTool(),
        DocxGenerateTool(),
        XlsxGenerateTool(),
        PptxGenerateTool(),
    ):
        gateway.register(tool)


__all__ = ["gateway", "register_default_tools"]
