import json
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from conversations.models import Conversation


class Command(BaseCommand):
    help = "Dump the most recent conversation(s) into JSON files named after their IDs."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--num",
            type=int,
            default=1,
            help="Number of most recent conversations to export (default: 1).",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        num = options["num"]
        if num < 1:
            raise CommandError("--num must be at least 1.")

        conversations = list(
            Conversation.objects.select_related("contact")
            .prefetch_related("messages")
            .order_by("-created_at")[:num]
        )

        if not conversations:
            self.stdout.write(self.style.WARNING("No conversations found to export."))
            return

        output_dir = Path.cwd()
        output_dir.mkdir(parents=True, exist_ok=True)

        for conversation in conversations:
            file_path = output_dir / f"{conversation.id}.json"
            payload = self._serialize_conversation(conversation)

            with file_path.open("w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, default=str)

            self.stdout.write(
                self.style.SUCCESS(f"Wrote conversation {conversation.id} to {file_path}")
            )

    def _serialize_conversation(self, conversation: Conversation) -> dict[str, Any]:
        messages = [
            {
                "id": str(message.id),
                "sender": message.sender,
                "body": message.body,
                "ai_job_id": message.ai_job_id,
                "created_at": self._format_datetime(message.created_at),
                "updated_at": self._format_datetime(message.updated_at),
            }
            for message in conversation.messages.all()
        ]

        return {
            "id": str(conversation.id),
            "title": conversation.title,
            "contact_id": conversation.contact_id,
            "last_response_job_id": conversation.last_response_job_id,
            "created_at": self._format_datetime(conversation.created_at),
            "updated_at": self._format_datetime(conversation.updated_at),
            "messages": messages,
        }

    def _format_datetime(self, value) -> str | None:
        if value is None:
            return None
        return timezone.localtime(value).isoformat()
