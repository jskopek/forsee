import uuid

from django.db import models
from django.forms.models import model_to_dict
from django.urls import reverse


class Contact(models.Model):
    """Stores basic information about a communication contact."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    relationship = models.CharField(max_length=100, blank=True)
    notes = models.TextField(blank=True)
    interests = models.TextField(blank=True)
    
    FORMALITY_CHOICES = [
        ("casual", "Casual - Friendly, natural, everyday speech"),
        ("polite", "Polite - Slightly more complete sentences, softer edges"),
        ("professional", "Professional - Clear, structured, no slang, no contractions"),
        ("warm", "Warm - Slightly more affectionate tone, supportive"),
        ("blunt", "Blunt - Direct, to-the-point, minimal social padding"),
    ]
    
    formality = models.CharField(
        max_length=100,
        choices=FORMALITY_CHOICES,
        default="casual",
    )
    personality = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        indexes = [
            models.Index(fields=["name"]),
        ]

    def __str__(self) -> str:
        return self.name

    def get_absolute_url(self) -> str:
        return reverse("contacts:detail", kwargs={"pk": self.pk})

    def get_profile_data(self) -> dict:
        return model_to_dict(self, fields=["name", "relationship", "formality", "notes", "interests", "personality"])
