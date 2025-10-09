from __future__ import annotations

import json
from typing import Any

from contacts.models import Contact
from django.contrib.auth.mixins import LoginRequiredMixin
from django.db.models import Prefetch
from django.http import HttpRequest, HttpResponse, HttpResponseBadRequest, HttpResponseRedirect
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse_lazy
from django.views import View, generic

from .forms import ConversationCreateForm, MessageForm
from .models import Conversation, Message
# from .services import create_conversation, create_user_message
# from .tasks import enqueue_contact_reply, enqueue_initial_contact_greeting


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
        # conversation = create_conversation(
        #     owner=self.request.user,
        #     contact=form.cleaned_data["contact"],
        #     title=form.cleaned_data.get("title") or None,
        # )
        # enqueue_initial_contact_greeting(conversation)
        return HttpResponseRedirect(conversation.get_absolute_url())


class ConversationQuickStartView(LoginRequiredMixin, View):
    def post(self, request: HttpRequest, contact_pk: str, *args: Any, **kwargs: Any) -> HttpResponse:
        contact = get_object_or_404(
            Contact.objects.select_related("user"),
            pk=contact_pk,
            user=request.user,
        )
        conversation = create_conversation(
            owner=request.user,
            contact=contact,
        )
        # enqueue_initial_contact_greeting(conversation)
        return redirect(conversation.get_absolute_url())


class ConversationDetailView(LoginRequiredMixin, generic.DetailView):
    model = Conversation
    template_name = "conversations/conversation_detail.html"
    context_object_name = "conversation"

    def get_queryset(self):
        return (
            Conversation.objects.filter(owner=self.request.user)
            .select_related("contact")
        )

    def get_context_data(self, **kwargs: Any) -> dict[str, Any]:
        context = super().get_context_data(**kwargs)
        context["message_form"] = MessageForm()
        context["messages"] = self.object.messages.order_by("created_at", "id")
        return context


class ConversationMessagesPartialView(LoginRequiredMixin, View):
    template_name = "conversations/partials/message_list.html"

    def get(self, request: HttpRequest, *args: Any, **kwargs: Any) -> HttpResponse:
        conversation = get_object_or_404(
            Conversation.objects.select_related("contact").prefetch_related("messages"),
            pk=kwargs["pk"],
            owner=request.user,
        )
        messages = conversation.messages.order_by("created_at", "id")
        return render(
            request,
            self.template_name,
            {
                "conversation": conversation,
                "messages": messages,
            },
        )


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

        # user_message = create_user_message(
        #     conversation=conversation,
        #     body=form.cleaned_data["body"],
        # )
        # enqueue_contact_reply(conversation, trigger_message=user_message)

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
