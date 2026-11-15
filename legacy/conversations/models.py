import uuid

from django.db import models
from django.urls import reverse


class Conversation(models.Model):
    """A single-user conversation log."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=255, blank=True)
    last_response_job_id = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        if self.title:
            return self.title
        return f"Conversation started {self.created_at:%Y-%m-%d %H:%M}"

    def get_absolute_url(self) -> str:
        return reverse("conversations:detail", kwargs={"pk": self.pk})


class Message(models.Model):
    """Individual message within a conversation."""

    class Sender(models.TextChoices):
        USER = "user", "User"
        CONTACT = "contact", "Contact"
        SYSTEM = "system", "System"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation,
        on_delete=models.CASCADE,
        related_name="messages",
    )
    sender = models.CharField(
        max_length=20,
        choices=Sender.choices,
        default=Sender.USER,
    )
    body = models.TextField()
    ai_job_id = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [
            models.Index(fields=["conversation", "created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.get_sender_display()}: {self.body[:50]}"

    @property
    def from_user(self) -> bool:
        return self.sender == self.Sender.USER

    @property
    def from_contact(self) -> bool:
        return self.sender == self.Sender.CONTACT
