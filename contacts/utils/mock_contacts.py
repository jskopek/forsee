from __future__ import annotations

from typing import Tuple

from django.db import transaction

from contacts.models import Contact
from contacts.services.mock_contact_profiles import (
    MockContactProfile,
    MockContactProfileGenerator,
)


def generate_profile(
    *,
    generator: MockContactProfileGenerator,
    patient_profile,
) -> MockContactProfile:
    return generator.generate(patient_profile=patient_profile)


@transaction.atomic
def create_mock_contact(
    *,
    generator: MockContactProfileGenerator,
    patient_profile,
    profile: MockContactProfile | None = None,
) -> Tuple[Contact, MockContactProfile]:
    if profile is None:
        profile = generate_profile(generator=generator, patient_profile=patient_profile)

    kwargs = profile.as_contact_kwargs()
    kwargs["name"] = _build_unique_name(kwargs["name"])

    contact = Contact.objects.create(
        **kwargs,
    )
    return contact, profile


def _build_unique_name(name: str) -> str:
    base_name = name.strip() or "Key contact"
    candidate = base_name
    counter = 2
    while Contact.objects.filter(name=candidate).exists():
        candidate = f"{base_name} ({counter})"
        counter += 1
    return candidate
