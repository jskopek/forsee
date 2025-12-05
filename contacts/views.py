from crispy_forms.helper import FormHelper
from django import forms
from django.db.models import Count, OuterRef, Subquery
from django.urls import reverse_lazy
from django.views.generic import CreateView, DeleteView, DetailView, ListView, UpdateView

from conversations.models import Message

from .models import Contact


class CrispyFormMixin:
    def get_form(self, form_class=None):
        form = super().get_form(form_class)
        form.helper = FormHelper()
        form.helper.template_pack = "tailwind"
        form.helper.form_tag = False
        for field_name in ("notes", "interests", "personality"):
            if field_name in form.fields:
                form.fields[field_name].widget = forms.Textarea(
                    attrs={"rows": 4, "placeholder": "Add context"}
                )
        return form


class ContactListView(ListView):
    model = Contact
    context_object_name = "contacts"
    paginate_by = 20


class ContactDetailView(DetailView):
    model = Contact

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        contact = self.object
        latest_message = (
            Message.objects.filter(conversation=OuterRef("pk"))
            .order_by("-created_at")
        )
        context["conversations"] = contact.conversations.annotate(
            message_count=Count("messages"),
            latest_message_body=Subquery(latest_message.values("body")[:1]),
            latest_message_sender=Subquery(latest_message.values("sender")[:1]),
            latest_message_at=Subquery(latest_message.values("created_at")[:1]),
        ).order_by("-updated_at", "-created_at")[:5]
        return context


class ContactCreateView(CrispyFormMixin, CreateView):
    model = Contact
    fields = ["name", "relationship", "formality", "interests", "personality", "notes"]


class ContactUpdateView(CrispyFormMixin, UpdateView):
    model = Contact
    fields = ["name", "relationship", "formality", "interests", "personality", "notes"]


class ContactDeleteView(DeleteView):
    model = Contact
    success_url = reverse_lazy("contacts:list")
    template_name = "confirm_delete.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["cancel_url"] = self.object.get_absolute_url()
        return context
