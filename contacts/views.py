from crispy_forms.helper import FormHelper
from django import forms
from django.contrib.auth.mixins import LoginRequiredMixin
from django.urls import reverse_lazy
from django.views.generic import CreateView, DeleteView, DetailView, ListView, UpdateView

from .models import Contact


class ContactMixin(LoginRequiredMixin):
    model = Contact

    def get_queryset(self):
        return Contact.objects.filter(user=self.request.user)


class CrispyFormMixin:
    def get_form(self, form_class=None):
        form = super().get_form(form_class)
        form.helper = FormHelper()
        form.helper.template_pack = "tailwind"
        form.helper.form_tag = False
        if "notes" in form.fields:
            form.fields["notes"].widget = forms.Textarea(
                attrs={"rows": 4, "placeholder": "Additional context"}
            )
        return form


class ContactListView(ContactMixin, ListView):
    context_object_name = "contacts"
    paginate_by = 20


class ContactDetailView(ContactMixin, DetailView):
    pass


class ContactCreateView(CrispyFormMixin, ContactMixin, CreateView):
    fields = ["name", "relationship", "notes"]

    def form_valid(self, form):
        form.instance.user = self.request.user
        return super().form_valid(form)


class ContactUpdateView(CrispyFormMixin, ContactMixin, UpdateView):
    fields = ["name", "relationship", "notes"]


class ContactDeleteView(ContactMixin, DeleteView):
    success_url = reverse_lazy("contacts:list")
    template_name = "confirm_delete.html"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["cancel_url"] = self.object.get_absolute_url()
        return context
