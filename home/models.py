from __future__ import annotations

from django.db import models


class PatientProfile(models.Model):
    """Singleton-like model that captures the single user's context."""

    full_name = models.CharField(max_length=255, blank=True)
    location = models.CharField(max_length=255, blank=True)
    medical_condition = models.TextField(blank=True)
    interests = models.TextField(blank=True)
    sports_teams = models.TextField(blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "patient profile"

    def __str__(self) -> str:
        return self.full_name or "Patient profile"

    def get_profile_data(self) -> dict[str, str]:
        return {
            "full_name": self.full_name,
            "location": self.location,
            "medical_condition": self.medical_condition,
            "interests": self.interests,
            "sports_teams": self.sports_teams,
        }

    @property
    def interests_list(self) -> list[str]:
        if not self.interests:
            return []
        return [chunk.strip() for chunk in self.interests.splitlines() if chunk.strip()]
