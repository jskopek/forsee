from __future__ import annotations

from typing import Any

from django.conf import settings
from django.db.models import Prefetch
from django.http import HttpRequest, HttpResponse
from django.shortcuts import redirect
from django.utils import timezone
from django.views import View, generic

from .models import Conversation, Message
from .utils import is_htmx


class ConversationListView(generic.ListView):
    model = Conversation
    template_name = "conversations/conversation_list.html"
    context_object_name = "conversations"

    def get_queryset(self):
        return (
            Conversation.objects.all()
            .prefetch_related(
                Prefetch(
                    "messages",
                    queryset=Message.objects.order_by("-created_at", "-id")[:1],
                    to_attr="latest_messages",
                )
            )
            .order_by("-updated_at", "-created_at")
        )


class ConversationCreateView(View):
    def get(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
        conversation = get_recent_empty_conversation()
        if conversation:
            return redirect(conversation.get_absolute_url())
        return redirect(create_conversation().get_absolute_url())

    def post(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
        title = (request.POST.get("title") or "").strip()
        conversation = get_recent_empty_conversation()
        if conversation and title:
            conversation.title = _clean_title(title)
            conversation.save(update_fields=["title", "updated_at"])
        elif not conversation:
            conversation = create_conversation(title=title)
        return redirect(conversation.get_absolute_url())


class ConversationStartView(ConversationCreateView):
    """Alias used for the homepage route."""
    pass


class ConversationDetailView(generic.DetailView):
    model = Conversation
    template_name = "conversations/conversation_detail.html"
    partial_template_name = "conversations/partials/message_list.html"
    context_object_name = "conversation"

    def get_template_names(self):
        if is_htmx(self.request) and self.partial_template_name:
            return [self.partial_template_name]
        return super().get_template_names()

    def get_context_data(self, **kwargs: Any) -> dict[str, Any]:
        context = super().get_context_data(**kwargs)
        context["messages"] = self.object.messages.order_by("created_at", "id")
        # Don't generate suggestions on page load - will be loaded via API
        context["suggestions"] = []
        context["suggestion_hint"] = ""
        # Don't generate hints on page load - will be loaded via API
        context["hints"] = []
        # Pusher configuration for real-time updates
        context["pusher_key"] = settings.PUSHER_KEY
        context["pusher_cluster"] = settings.PUSHER_CLUSTER
        context["recent_conversations"] = (
            Conversation.objects.exclude(pk=self.object.pk)
            .order_by("-updated_at", "-created_at")[:5]
        )
        return context


class ConversationKeyboardView(generic.DetailView):
    """View to serve the keyboard UI for a conversation."""
    model = Conversation
    template_name = "conversations/keyboard.html"
    context_object_name = "conversation"

    def get_context_data(self, **kwargs: Any) -> dict[str, Any]:
        context = super().get_context_data(**kwargs)
        # Determine if we're in development mode
        context["is_development"] = settings.DEBUG
        # React dev server URL (adjust port if needed)
        context["react_dev_url"] = getattr(settings, 'REACT_DEV_SERVER_URL', 'http://localhost:3000')
        return context


def create_conversation(*, title: str | None = None) -> Conversation:
    """Create a new conversation with a friendly default title."""
    cleaned = _clean_title(title)
    return Conversation.objects.create(title=cleaned)


def get_recent_empty_conversation() -> Conversation | None:
    conversation = Conversation.objects.order_by("-created_at", "-id").first()
    if conversation and not conversation.messages.exists():
        return conversation
    return None


def _clean_title(title: str | None) -> str:
    if title:
        cleaned = " ".join(title.split())[:255]
        if cleaned:
            return cleaned
    return timezone.localtime().strftime("Conversation %b %d, %Y %I:%M %p")
