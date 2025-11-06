import uuid

from django.db import models


class OpenAIRequest(models.Model):
    """Stores exact request and response data from OpenAI API calls."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    
    # Request data - stored as JSON
    request_data = models.JSONField(help_text="Exact request sent to OpenAI API")
    
    # Response data - stored as JSON
    response_data = models.JSONField(help_text="Exact response received from OpenAI API")

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["created_at"]),
        ]

    def __str__(self) -> str:
        return f"OpenAI Request - {self.created_at}"

