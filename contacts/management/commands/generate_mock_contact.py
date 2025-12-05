import json
import os
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from contacts.services.mock_contact_profiles import (
    DEFAULT_CONTACT_MODEL,
    DEFAULT_CONTACT_TEMPERATURE,
    MockContactProfileError,
    MockContactProfileGenerator,
)
from contacts.utils.mock_contacts import create_mock_contact, generate_profile
from home.utils import get_patient_profile


class Command(BaseCommand):
    help = (
        "Generates mock contacts for the single ALS user profile using OpenAI and "
        "persists them as Contact records."
    )
    requires_system_checks: list[str] = []

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--count",
            type=int,
            default=1,
            help="Number of contacts to generate (default: 1).",
        )
        parser.add_argument(
            "--model",
            type=str,
            default=None,
            help=f"Override the OpenAI model (default: {DEFAULT_CONTACT_MODEL}).",
        )
        parser.add_argument(
            "--temperature",
            type=float,
            default=None,
            help=f"Override the sampling temperature (default: {DEFAULT_CONTACT_TEMPERATURE}).",
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
            help="Fetch contact data from OpenAI but do not create database records. Outputs JSON instead.",
        )

    def handle(self, *args, **options) -> None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise CommandError("OPENAI_API_KEY environment variable is not set.")

        patient_profile = get_patient_profile()

        count = options["count"]
        if count < 1:
            raise CommandError("--count must be at least 1.")

        model = options.get("model") or DEFAULT_CONTACT_MODEL
        temperature = options.get("temperature")
        if temperature is None:
            temperature = DEFAULT_CONTACT_TEMPERATURE
        max_output_tokens = options.get("max_output_tokens") or 650
        dry_run = options["dry_run"]

        generator = MockContactProfileGenerator(
            model=model,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )

        created_contacts: list[Any] = []

        for _ in range(count):
            try:
                profile = generate_profile(generator=generator, patient_profile=patient_profile)
            except MockContactProfileError as error:
                raise CommandError(f"Failed to generate mock contact profile: {error}") from error

            if dry_run:
                data = profile.as_contact_kwargs()
                self.stdout.write(json.dumps(data, indent=2))
                continue

            contact, _ = create_mock_contact(
                generator=generator,
                patient_profile=patient_profile,
                profile=profile,
            )
            created_contacts.append(contact)
            self.stdout.write(
                self.style.SUCCESS(
                    f"Created mock contact {contact.name} ({contact.relationship})"
                )
            )

        if not dry_run and created_contacts:
            self.stdout.write(
                self.style.MIGRATE_HEADING(
                    f"Successfully created {len(created_contacts)} mock contact(s)."
                )
            )
