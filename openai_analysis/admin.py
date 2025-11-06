from django.contrib import admin
from django.utils.html import format_html

from .models import OpenAIRequest


@admin.register(OpenAIRequest)
class OpenAIRequestAdmin(admin.ModelAdmin):
    list_display = ("id", "created_at")
    list_filter = ("created_at",)
    ordering = ("-created_at",)
    readonly_fields = ("id", "created_at", "request_data", "response_data", "formatted_request", "formatted_response")
    
    fieldsets = (
        ("Basic Info", {
            "fields": ("id", "created_at")
        }),
        ("Request Data", {
            "fields": ("formatted_request", "request_data"),
            "classes": ("collapse",)
        }),
        ("Response Data", {
            "fields": ("formatted_response", "response_data"),
            "classes": ("collapse",)
        }),
    )

    @admin.display(description="Request (formatted)")
    def formatted_request(self, obj: OpenAIRequest) -> str:
        import json
        formatted = json.dumps(obj.request_data, indent=2, ensure_ascii=False)
        return format_html("<pre style='white-space: pre-wrap;'>{}</pre>", formatted)

    @admin.display(description="Response (formatted)")
    def formatted_response(self, obj: OpenAIRequest) -> str:
        import json
        formatted = json.dumps(obj.response_data, indent=2, ensure_ascii=False)
        return format_html("<pre style='white-space: pre-wrap;'>{}</pre>", formatted)

