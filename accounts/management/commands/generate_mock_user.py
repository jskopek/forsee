import json
import os
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from accounts.services.mock_user_profiles import (
    DEFAULT_MODEL,
    DEFAULT_TEMPERATURE,
    MockUserProfileError,
    MockUserProfileGenerator,
)
from accounts.utils.mock_users import create_mock_user, generate_profile_with_email


class Command(BaseCommand):
    help = "Generates mock ALS user personas using OpenAI and stores them as user records."
    requires_system_checks: list[str] = []

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--count",
            type=int,
            default=1,
            help="Number of personas to generate (default: 1).",
        )
        parser.add_argument(
            "--domain",
            type=str,
            default=os.getenv("MOCK_USER_EMAIL_DOMAIN", "mock.als.local"),
            help="Email domain to use for generated users (default: mock.als.local).",
        )
        parser.add_argument(
            "--model",
            type=str,
            default=None,
            help=f"Override the OpenAI model (default: {DEFAULT_MODEL}).",
        )
        parser.add_argument(
            "--temperature",
            type=float,
            default=None,
            help=f"Override the sampling temperature (default: {DEFAULT_TEMPERATURE}).",
        )
        parser.add_argument(
            "--max-output-tokens",
            type=int,
            default=None,
            help="Override the maximum number of output tokens for the OpenAI call.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Fetch personas from OpenAI but do not create users. Outputs JSON instead.",
        )

    def handle(self, *args, **options) -> None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise CommandError("OPENAI_API_KEY environment variable is not set.")

        count = options["count"]
        if count < 1:
            raise CommandError("--count must be at least 1.")

        model = options.get("model") or DEFAULT_MODEL
        temperature = options.get("temperature")
        if temperature is None:
            temperature = DEFAULT_TEMPERATURE
        max_output_tokens = options.get("max_output_tokens") or 600
        dry_run = options["dry_run"]
        email_domain = options["domain"].strip()

        generator = MockUserProfileGenerator(
            model=model,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )

        created_users: list[Any] = []

        for _ in range(count):
            try:
                profile, email = generate_profile_with_email(
                    generator=generator, email_domain=email_domain
                )
            except MockUserProfileError as error:
                raise CommandError(f"Failed to generate mock user profile: {error}") from error

            if dry_run:
                data = profile.as_user_kwargs()
                data["email"] = email
                self.stdout.write(json.dumps(data, indent=2))
                continue

            user, _ = create_mock_user(
                generator=generator,
                profile=profile,
                email=email,
            )
            created_users.append(user)
            self.stdout.write(
                self.style.SUCCESS(f"Created mock user {user.full_name} <{user.email}>")
            )

        if not dry_run and created_users:
            self.stdout.write(
                self.style.MIGRATE_HEADING(
                    f"Successfully created {len(created_users)} mock user(s)."
                )
            )
