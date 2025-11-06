from __future__ import annotations

import json
from typing import Any

from contacts.models import Contact
from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin, UserPassesTestMixin
from django.db.models import Prefetch
from django.http import HttpRequest, HttpResponse, HttpResponseBadRequest, HttpResponseForbidden, HttpResponseRedirect
from django.shortcuts import redirect, render
from django.urls import reverse_lazy
from django.views import View, generic
from django.views.generic.detail import SingleObjectMixin

from .services.mock_conversations import MockConversationError
from .utils import (
    create_mock_conversation,
    generate_contact_greeting,
    generate_contact_reply,
    generate_reply_suggestions,
    is_htmx,
    normalize_interests,
)
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
            owner=contact.user,
            contact=contact,
            title=form.cleaned_data.get("title") or contact.name,
        )
        generate_contact_greeting(conversation)
        return HttpResponseRedirect(conversation.get_absolute_url())


class ConversationQuickStartView(UserPassesTestMixin, LoginRequiredMixin, SingleObjectMixin, View):
    model = Contact

    def test_func(self):
        return self.get_object().user == self.request.user or self.request.user.is_superuser

    def post(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
        contact = self.get_object()
        conversation = Conversation.objects.create(
            owner=contact.user,
            contact=contact,
            title=contact.name,
        )
        generate_contact_greeting(conversation)
        return redirect(conversation.get_absolute_url())


class ConversationGenerateView(UserPassesTestMixin, LoginRequiredMixin, SingleObjectMixin, View):
    model = Contact

    def test_func(self):
        return self.get_object().user == self.request.user or self.request.user.is_superuser

    def post(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
        contact = self.get_object()
        if contact.user != self.request.user and not self.request.user.is_superuser:
            return HttpResponseForbidden()
        try:
            conversation, transcript = create_mock_conversation(user=contact.user, contact=self.get_object())
        except MockConversationError as error:
            messages.error(self.request, f"Unable to generate conversation: {error}")
            return redirect(contact.get_absolute_url())
        messages.success(
            self.request,
            f"Generated conversation with {contact.name} ({len(transcript.messages)} messages).",
        )
        return redirect(conversation.get_absolute_url())


class ConversationDetailView(UserPassesTestMixin, LoginRequiredMixin, generic.DetailView):
    model = Conversation
    template_name = "conversations/conversation_detail.html"
    partial_template_name = "conversations/partials/message_list.html"
    context_object_name = "conversation"

    def test_func(self):
        return self.get_object().owner == self.request.user or self.request.user.is_superuser

    def get_template_names(self):
        if is_htmx(self.request) and self.partial_template_name:
            return [self.partial_template_name]
        return super().get_template_names()

    def get_context_data(self, **kwargs: Any) -> dict[str, Any]:
        context = super().get_context_data(**kwargs)
        context["message_form"] = MessageForm()
        context["messages"] = self.object.messages.order_by("created_at", "id")
        # Don't generate suggestions on page load - will be loaded via HTMX
        context["suggestions"] = []
        context["suggestion_hint"] = ""
        return context


class ConversationMessageCreateView(UserPassesTestMixin, LoginRequiredMixin, SingleObjectMixin, View):
    model = Conversation

    def test_func(self):
        return self.get_object().owner == self.request.user or self.request.user.is_superuser

    def post(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
        conversation = self.get_object()
        form = MessageForm(request.POST)
        if not form.is_valid():
            error_text = form.errors.get("body", ["Unable to send your message."])[0]
            return HttpResponseBadRequest(error_text)

        user_message: Message = conversation.messages.create(sender=Message.Sender.USER, body=form.cleaned_data["body"])
        generate_contact_reply(conversation, trigger_message=user_message)

        if is_htmx(request):
            messages_qs = conversation.messages.order_by("created_at", "id")
            response = render(request, "conversations/partials/message_list.html", {
                "conversation": conversation,
                "messages": messages_qs
            })
            response["HX-Trigger"] = json.dumps({"message-sent": True})
            return response
        else:
            return redirect(conversation.get_absolute_url())


class ConversationSuggestionsView(UserPassesTestMixin, LoginRequiredMixin, SingleObjectMixin, View):
    model = Conversation
    template_name = "conversations/partials/suggestion_panel.html"

    def test_func(self):
        return self.get_object().owner == self.request.user or self.request.user.is_superuser

    def post(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
        conversation = self.get_object()
        hint_text = request.POST.get('hint', '').strip()
        suggestions = generate_reply_suggestions(conversation, hint_text)
        return render(request, self.template_name, {
            'conversation': conversation,
            'suggestions': suggestions,
            'suggestion_hint': hint_text,
        })


