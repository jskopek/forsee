from __future__ import annotations

import json
import re
from typing import Any

from contacts.models import Contact
from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin
from django.db.models import Prefetch
from django.http import HttpRequest, HttpResponse, HttpResponseBadRequest, HttpResponseRedirect
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse_lazy
from django.views import View, generic

from .services.mock_conversations import MockConversationError
from .utils import create_mock_conversation, generate_contact_greeting, generate_contact_reply
from .forms import ConversationCreateForm, MessageForm
from .models import Conversation, Message


class ConversationListView(LoginRequiredMixin, generic.ListView):
    model = Conversation
    template_name = "conversations/conversation_list.html"
    context_object_name = "conversations"

    def get_queryset(self):
        return (
            Conversation.objects.filter(owner=self.request.user)
            .select_related("contact")
            .prefetch_related(
                Prefetch(
                    "messages",
                    queryset=Message.objects.order_by("-created_at", "-id")[:1],
                    to_attr="latest_messages",
                )
            )
            .order_by("-updated_at", "-created_at")
        )


class ConversationCreateView(LoginRequiredMixin, generic.FormView):
    template_name = "conversations/conversation_form.html"
    form_class = ConversationCreateForm
    success_url = reverse_lazy("conversations:list")  # fallback

    def get_form_kwargs(self) -> dict[str, Any]:
        kwargs = super().get_form_kwargs()
        kwargs["user"] = self.request.user
        return kwargs

    def form_valid(self, form: ConversationCreateForm) -> HttpResponse:
        contact = form.cleaned_data["contact"]
        conversation = Conversation.objects.create(
            owner=self.request.user,
            contact=contact,
            title=form.cleaned_data.get("title") or contact.name,
            user_snapshot=self.request.user.profile_data,
            contact_snapshot=contact.profile_data,
        )
        generate_contact_greeting(conversation)
        return HttpResponseRedirect(conversation.get_absolute_url())


class ConversationQuickStartView(LoginRequiredMixin, View):
    def post(self, request: HttpRequest, contact_pk: str, *args: Any, **kwargs: Any) -> HttpResponse:
        contact = get_object_or_404(
            Contact.objects.select_related("user"),
            pk=contact_pk,
            user=request.user,
        )
        conversation = Conversation.objects.create(
            owner=request.user,
            contact=contact,
            title=contact.name,
            user_snapshot=request.user.profile_data,
            contact_snapshot=contact.profile_data,
        )
        generate_contact_greeting(conversation)
        return redirect(conversation.get_absolute_url())


class ConversationGenerateView(LoginRequiredMixin, View):
    def post(self, request: HttpRequest, contact_pk: str, *args: Any, **kwargs: Any) -> HttpResponse:
        contact = get_object_or_404(
            Contact.objects.select_related("user"),
            pk=contact_pk,
            user=request.user,
        )
        try:
            conversation, transcript = create_mock_conversation(user=request.user, contact=contact)
        except MockConversationError as error:
            messages.error(request, f"Unable to generate conversation: {error}")
            return redirect(contact.get_absolute_url())
        messages.success(
            request,
            f"Generated conversation with {contact.name} ({len(transcript.messages)} messages).",
        )
        return redirect(conversation.get_absolute_url())


class ConversationDetailView(LoginRequiredMixin, generic.DetailView):
    model = Conversation
    template_name = "conversations/conversation_detail.html"
    partial_template_name = "conversations/partials/message_list.html"
    context_object_name = "conversation"

    def get_queryset(self):
        return (
            Conversation.objects.filter(owner=self.request.user)
            .select_related("contact")
        )

    def get_template_names(self):
        if _is_htmx(self.request) and self.partial_template_name:
            return [self.partial_template_name]
        return super().get_template_names()

    def get_context_data(self, **kwargs: Any) -> dict[str, Any]:
        context = super().get_context_data(**kwargs)
        context["message_form"] = MessageForm()
        context["messages"] = self.object.messages.order_by("created_at", "id")
        if self.object.contact_snapshot:
            snapshot = dict(self.object.contact_snapshot)
            snapshot["interests"] = _normalize_interests(snapshot.get("interests"))
            self.object.contact_snapshot = snapshot
        if self.object.user_snapshot:
            snapshot = dict(self.object.user_snapshot)
            snapshot["interests"] = _normalize_interests(snapshot.get("interests"))
            self.object.user_snapshot = snapshot
        return context


class ConversationMessageCreateView(LoginRequiredMixin, View):
    template_name = "conversations/partials/message_list.html"

    def post(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
        conversation = get_object_or_404(
            Conversation.objects.select_related("contact"),
            pk=kwargs["pk"],
            owner=request.user,
        )
        form = MessageForm(request.POST)
        if not form.is_valid():
            error_text = form.errors.get("body", ["Unable to send your message."])[0]
            return HttpResponseBadRequest(error_text)

        user_message = conversation.messages.create(
            sender=Message.Sender.USER,
            body=form.cleaned_data["body"],
        )
        generate_contact_reply(conversation, trigger_message=user_message)

        if _is_htmx(request):
            messages_qs = conversation.messages.order_by("created_at", "id")
            response = render(
                request,
                self.template_name,
                {"conversation": conversation, "messages": messages_qs},
            )
            response["HX-Trigger"] = json.dumps({"message-sent": True})
            return response

        return redirect(conversation.get_absolute_url())


def _is_htmx(request: HttpRequest) -> bool:
    return request.headers.get("HX-Request", "").lower() == "true"


def _normalize_interests(raw: Any) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(item).strip() for item in raw if str(item).strip()]
    if isinstance(raw, str):
        cleaned = raw.replace("\r", "")
        if not cleaned.strip():
            return []
        parts = re.split(r"[\n;,]", cleaned)
        if len(parts) == 1:
            text = parts[0].strip()
            return [text] if text else []
        normalized: list[str] = []
        for part in parts:
            text = part.strip(" \t•*-")
            if text:
                normalized.append(text)
        return normalized
    text = str(raw).strip()
    return [text] if text else []
