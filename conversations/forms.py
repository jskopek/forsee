from __future__ import annotations

from django import forms

from contacts.models import Contact

from .models import Message


class ConversationCreateForm(forms.Form):
    contact = forms.ModelChoiceField(
        queryset=Contact.objects.none(),
        label="Contact",
    )
    title = forms.CharField(
        label="Title",
        max_length=255,
        required=False,
    )

    def __init__(self, *args, user, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.user = user
        self.fields["contact"].queryset = Contact.objects.filter(user=user).order_by("name")

    def clean_contact(self) -> Contact:
        contact = self.cleaned_data["contact"]
        if contact.user_id != self.user.id:
            raise forms.ValidationError("You can only create conversations with your own contacts.")
        return contact


class MessageForm(forms.ModelForm):
    class Meta:
        model = Message
        fields = ["body"]
        widgets = {
            "body": forms.Textarea(
                attrs={
                    "rows": 5,
                    "placeholder": "Type your message…",
                    "class": "w-full border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring focus:ring-blue-200 resize-none",
                    "x-ref": "messageInput",
                    "x-model": "message",
                    "@input": "handleInput($event)",
                    "@keydown.enter": "submitOnEnter($event)",
                    "x-bind:disabled": "isSubmitting",
                }
            )
        }
        labels = {"body": ""}

    def clean_body(self) -> str:
        text = self.cleaned_data["body"].strip()
        if not text:
            raise forms.ValidationError("Please enter a message before sending.")
        return text
