from __future__ import annotations

from typing import Tuple

from django.db import transaction

from contacts.models import Contact
from contacts.services.mock_contact_profiles import (
    MockContactProfile,
    MockContactProfileGenerator,
)


def generate_profile_for_user(
    *,
    generator: MockContactProfileGenerator,
    user,
) -> MockContactProfile:
    return generator.generate(user=user)


@transaction.atomic
def create_mock_contact(
    *,
    generator: MockContactProfileGenerator,
    user,
    profile: MockContactProfile | None = None,
) -> Tuple[Contact, MockContactProfile]:
    if profile is None:
        profile = generate_profile_for_user(generator=generator, user=user)

    kwargs = profile.as_contact_kwargs()
    kwargs["name"] = _build_unique_name(kwargs["name"], user=user)

    contact = Contact.objects.create(
        user=user,
        **kwargs,
    )
    return contact, profile


def _build_unique_name(name: str, *, user) -> str:
    base_name = name.strip() or "Key contact"
    candidate = base_name
    counter = 2
    while Contact.objects.filter(user=user, name=candidate).exists():
        candidate = f"{base_name} ({counter})"
        counter += 1
    return candidate
