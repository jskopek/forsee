import os
from typing import Tuple

from django.contrib.auth import get_user_model
from django.utils.text import slugify

from accounts.services.mock_user_profiles import (
    MockUserProfile,
    MockUserProfileError,
    MockUserProfileGenerator,
)

DEFAULT_EMAIL_DOMAIN = os.getenv("MOCK_USER_EMAIL_DOMAIN", "mock.als.local")


def generate_profile_with_email(
    *,
    generator: MockUserProfileGenerator,
    email_domain: str | None = None,
) -> Tuple[MockUserProfile, str]:
    profile = generator.generate()
    domain = (email_domain or DEFAULT_EMAIL_DOMAIN).strip()
    if not domain:
        domain = DEFAULT_EMAIL_DOMAIN

    user_model = get_user_model()
    email = _build_unique_email(profile.full_name, domain, user_model)
    return profile, email


def create_mock_user(
    *,
    generator: MockUserProfileGenerator,
    profile: MockUserProfile | None = None,
    email: str | None = None,
    email_domain: str | None = None,
) -> Tuple['User', MockUserProfile]:
    if profile is None or email is None:
        profile, email = generate_profile_with_email(
            generator=generator,
            email_domain=email_domain,
        )

    user_model = get_user_model()
    user = user_model.objects.create_user(
        email=email,
        password=None,
        **profile.as_user_kwargs(),
    )
    return user, profile


def _build_unique_email(full_name: str, domain: str, user_model) -> str:
    base_slug = slugify(full_name).replace("-", ".")
    if not base_slug:
        base_slug = "persona"

    candidate = f"{base_slug}@{domain}"
    counter = 2
    while user_model.objects.filter(email=candidate).exists():
        candidate = f"{base_slug}{counter}@{domain}"
        counter += 1
    return candidate
