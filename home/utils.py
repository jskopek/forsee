from __future__ import annotations

from .models import PatientProfile


def get_patient_profile() -> PatientProfile:
    """Return the single patient profile, creating a blank one if necessary."""
    profile, _ = PatientProfile.objects.get_or_create(pk=1)
    return profile


def get_patient_profile_data() -> dict[str, str]:
    """Convenience helper for serializing the patient's details."""
    return get_patient_profile().get_profile_data()
