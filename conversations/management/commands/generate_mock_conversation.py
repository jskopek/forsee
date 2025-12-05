import json
import os
import uuid
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from contacts.models import Contact
from home.utils import get_patient_profile
from conversations.utils_mock_conversations import (
    DEFAULT_MAX_TURNS,
    DEFAULT_MAX_WORDS,
    DEFAULT_MIN_TURNS,
    MockConversationError,
    MockConversationGenerator,
    create_mock_conversation,
    generate_mock_conversation_transcript,
)


class Command(BaseCommand):
    help = (
        "Generates realistic conversations between an ALS user and one of their contacts using OpenAI "
        "and optionally persists them as Conversation records."
    )
    requires_system_checks: list[str] = []

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--contact",
            required=True,
            help="Contact identifier (UUID primary key or name) to use as the conversation partner.",
        )
        parser.add_argument(
            "--count",
            type=int,
            default=1,
            help="Number of conversations to generate (default: 1).",
        )
        parser.add_argument(
            "--min-turns",
            type=int,
            default=DEFAULT_MIN_TURNS,
            help=f"Minimum number of messages to aim for (default: {DEFAULT_MIN_TURNS}).",
        )
        parser.add_argument(
            "--max-turns",
            type=int,
            default=DEFAULT_MAX_TURNS,
            help=f"Maximum number of messages to allow (default: {DEFAULT_MAX_TURNS}, hard limit 50).",
        )
        parser.add_argument(
            "--max-words",
            type=int,
            default=DEFAULT_MAX_WORDS,
            help=f"Maximum total word count across all messages (default: {DEFAULT_MAX_WORDS}).",
        )
        parser.add_argument(
            "--model",
            type=str,
            default=None,
            help="Override the OpenAI model to use.",
        )
        parser.add_argument(
            "--temperature",
            type=float,
            default=None,
            help="Override the sampling temperature.",
        )
        parser.add_argument(
            "--max-output-tokens",
            type=int,
            default=None,
            help="Override the maximum output tokens for the OpenAI request.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Generate the conversation but do not persist it. Outputs the transcript JSON instead.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise CommandError("OPENAI_API_KEY environment variable is not set.")

        contact_identifier = options["contact"]
        contact = self._resolve_contact(contact_identifier)
        if contact is None:
            raise CommandError(f"Could not find contact with identifier '{contact_identifier}'.")

        patient_profile = get_patient_profile()

        count = options["count"]
        if count < 1:
            raise CommandError("--count must be at least 1.")

        min_turns = max(2, options["min_turns"])
        max_turns = options["max_turns"]
        if max_turns < min_turns:
            raise CommandError("--max-turns must be greater than or equal to --min-turns.")
        if max_turns > 50:
            self.stdout.write(self.style.WARNING("Capping --max-turns to 50."))
            max_turns = 50

        max_words = options["max_words"]
        if max_words <= 0:
            raise CommandError("--max-words must be a positive integer.")

        generator_kwargs = {}
        if options.get("model"):
            generator_kwargs["model"] = options["model"]
        if options.get("temperature") is not None:
            generator_kwargs["temperature"] = options["temperature"]
        if options.get("max_output_tokens"):
            generator_kwargs["max_output_tokens"] = options["max_output_tokens"]

        try:
            generator = MockConversationGenerator(**generator_kwargs)
        except MockConversationError as error:
            raise CommandError(str(error)) from error

        dry_run = options["dry_run"]
        created = []

        for _ in range(count):
            try:
                if dry_run:
                    transcript = generate_mock_conversation_transcript(
                        patient_profile=patient_profile,
                        contact=contact,
                        generator=generator,
                        min_turns=min_turns,
                        max_turns=max_turns,
                        max_words=max_words,
                    )
                    payload = _transcript_to_dict(transcript)
                    self.stdout.write(json.dumps(payload, indent=2))
                    continue

                conversation, transcript = create_mock_conversation(
                    patient_profile=patient_profile,
                    contact=contact,
                    generator=generator,
                    min_turns=min_turns,
                    max_turns=max_turns,
                    max_words=max_words,
                )
                created.append(conversation)
                self.stdout.write(
                    self.style.SUCCESS(
                        f"Created conversation {conversation.pk} with {len(transcript.messages)} messages."
                    )
                )
            except MockConversationError as error:
                raise CommandError(f"Failed to generate conversation: {error}") from error

        if not dry_run and created:
            self.stdout.write(
                self.style.MIGRATE_HEADING(
                    f"Successfully created {len(created)} conversation(s) for {contact.name}."
                )
            )

    def _resolve_contact(self, identifier: str) -> Contact | None:
        queryset = Contact.objects.all()
        try:
            contact_uuid = uuid.UUID(str(identifier))
        except (ValueError, TypeError):
            contact_uuid = None

        if contact_uuid:
            return queryset.filter(pk=contact_uuid).first()

        # Fall back to name-based lookup (case-insensitive). Only works if unique for the user.
        matches = list(queryset.filter(name__iexact=identifier))
        if len(matches) == 1:
            return matches[0]
        return None


def _transcript_to_dict(transcript):
    return {
        "title": transcript.title,
        "summary": transcript.summary,
        "messages": [
            {"sender": message.sender, "body": message.body}
            for message in transcript.messages
        ],
    }
