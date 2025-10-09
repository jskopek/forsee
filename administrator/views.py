from crispy_forms.helper import FormHelper
from django import forms
from django.contrib.auth import get_user_model
from django.contrib.auth.mixins import LoginRequiredMixin, UserPassesTestMixin
from django.core.exceptions import PermissionDenied
from django.shortcuts import get_object_or_404, redirect
from django.urls import reverse, reverse_lazy
from django.views.generic import DeleteView, DetailView, ListView, UpdateView, View
from accounts.services.mock_user_profiles import MockUserProfileError, MockUserProfileGenerator
from accounts.utils.mock_users import create_mock_user
from contacts.services.mock_contact_profiles import (
    MockContactProfileError,
    MockContactProfileGenerator,
)
from contacts.utils.mock_contacts import create_mock_contact

User = get_user_model()


class SuperuserRequiredMixin(LoginRequiredMixin, UserPassesTestMixin):
    raise_exception = True

    def test_func(self):
        return self.request.user.is_superuser


class AdminFormMixin:
    def get_form(self, form_class=None):
        form = super().get_form(form_class)
        form.helper = FormHelper()
        form.helper.template_pack = "tailwind"
        form.helper.form_tag = False
        for field_name in ("medical_condition", "interests", "sports_teams"):
            if field_name in form.fields:
                form.fields[field_name].widget = forms.Textarea(
                    attrs={"rows": 3, "placeholder": "Add details"}
                )
        return form


class DashboardView(SuperuserRequiredMixin, ListView):
    model = User
    template_name = "administrator/user_list.html"
    context_object_name = "users"

    def get_queryset(self):
        return User.objects.order_by("email").exclude(pk=self.request.user.pk)

class UserDetailView(SuperuserRequiredMixin, DetailView):
    model = User
    template_name = "administrator/user_detail.html"
    context_object_name = "person"

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["contacts"] = self.object.contacts.order_by("name")
        context["edit_url"] = reverse("administrator:user-edit", args=[self.object.pk])
        context["delete_url"] = reverse("administrator:user-delete", args=[self.object.pk])
        return context


class UserUpdateView(AdminFormMixin, SuperuserRequiredMixin, UpdateView):
    model = User
    fields = [
        "email",
        "location",
        "medical_condition",
        "interests",
        "sports_teams",
        "is_active",
        "is_staff",
    ]
    template_name = "administrator/user_form.html"
    success_url = reverse_lazy("administrator:dashboard")


class UserDeleteView(SuperuserRequiredMixin, DeleteView):
    model = User
    success_url = reverse_lazy("administrator:dashboard")
    template_name = "confirm_delete.html"

    def get_object(self, queryset=None):
        obj = super().get_object(queryset)
        if obj == self.request.user:
            raise PermissionDenied("You cannot delete your own account.")
        return obj

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context["cancel_url"] = reverse_lazy("administrator:dashboard")
        return context


class GenerateUsersView(SuperuserRequiredMixin, View):
    def post(self, request):
        try:
            user, _ = create_mock_user(generator=MockUserProfileGenerator())
        except MockUserProfileError as error:
            return redirect("administrator:dashboard")
        return redirect("administrator:user-detail", pk=user.pk)


class GenerateContactView(SuperuserRequiredMixin, View):
    def post(self, request, pk):
        person = get_object_or_404(User, pk=pk)
        try:
            contact, _ = create_mock_contact(
                generator=MockContactProfileGenerator(),
                user=person,
            )
        except MockContactProfileError:
            return redirect("administrator:user-detail", pk=person.pk)
        return redirect("contacts:detail", pk=contact.pk)
