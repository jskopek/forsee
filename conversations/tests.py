from __future__ import annotations

from unittest.mock import patch

from django.test import TestCase
from django.urls import reverse

from accounts.models import User
from contacts.models import Contact
from conversations import utils
from conversations.models import Conversation, Message


class ConversationViewTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(email="owner@example.com", password="password", full_name="Owner User")
        self.contact = Contact.objects.create(
            user=self.user,
            name="Jordan",
            relationship="Respiratory therapist",
            personality="Calm and data-driven.",
        )
        self.conversation = Conversation.objects.create(
            owner=self.user,
            contact=self.contact,
            title=self.contact.name,
            user_snapshot=self.user.profile_data,
            contact_snapshot=self.contact.profile_data,
        )
        self.client.force_login(self.user)

    def test_create_view_creates_conversation_and_triggers_greeting(self) -> None:
        with patch("conversations.views.generate_contact_greeting") as greeting_mock:
            response = self.client.post(
                reverse("conversations:create"),
                {"contact": self.contact.pk, "title": "Morning check-in"},
            )

        self.assertEqual(response.status_code, 302)
        new_conversation = Conversation.objects.exclude(pk=self.conversation.pk).get()
        self.assertEqual(new_conversation.title, "Morning check-in")
        greeting_mock.assert_called_once_with(new_conversation)

    def test_message_send_creates_user_message_and_enqueues_reply(self) -> None:
        with patch("conversations.views.generate_contact_reply") as reply_mock:
            response = self.client.post(
                reverse("conversations:message-send", kwargs={"pk": self.conversation.pk}),
                {"body": "Hello there!"},
                HTTP_HX_REQUEST="true",
            )

        self.assertEqual(response.status_code, 200)
        message = self.conversation.messages.filter(sender=Message.Sender.USER).first()
        self.assertIsNotNone(message)
        self.assertEqual(message.body, "Hello there!")
        reply_mock.assert_called_once()

    def test_message_send_requires_ownership(self) -> None:
        other_user = User.objects.create_user(email="intruder@example.com", password="password")
        self.client.force_login(other_user)

        response = self.client.post(
            reverse("conversations:message-send", kwargs={"pk": self.conversation.pk}),
            {"body": "Should not work"},
        )

        self.assertEqual(response.status_code, 404)

    def test_quick_start_creates_conversation(self) -> None:
        with patch("conversations.views.generate_contact_greeting") as greeting_mock:
            response = self.client.post(
                reverse("conversations:quick-start", kwargs={"contact_pk": self.contact.pk}),
            )

        self.assertEqual(response.status_code, 302)
        new_conversation = (
            Conversation.objects.filter(owner=self.user, contact=self.contact)
            .exclude(pk=self.conversation.pk)
            .get()
        )
        self.assertEqual(response.url, new_conversation.get_absolute_url())
        greeting_mock.assert_called_once_with(new_conversation)


class ConversationAIResponseTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(email="task-user@example.com", password="password", full_name="Task User")
        self.contact = Contact.objects.create(
            user=self.user,
            name="Nina",
            relationship="Care coordinator",
            personality="Organised and optimistic.",
        )
        self.conversation = Conversation.objects.create(
            owner=self.user,
            contact=self.contact,
            title=self.contact.name,
            user_snapshot=self.user.profile_data,
            contact_snapshot=self.contact.profile_data,
        )

    @patch("conversations.utils.ask_openai", return_value="Hello from AI!")
    def test_generate_contact_greeting_appends_message(self, ask_mock) -> None:
        message = utils.generate_contact_greeting(str(self.conversation.pk))

        self.assertEqual(message.sender, Message.Sender.CONTACT)
        self.assertEqual(message.body, "Hello from AI!")
        ask_mock.assert_called_once()

    @patch("conversations.utils.ask_openai", return_value="Thanks for the update!")
    def test_generate_contact_reply_uses_latest_user_message(self, ask_mock) -> None:
        user_message = self.conversation.messages.create(
            sender=Message.Sender.USER,
            body="Status check.",
        )

        reply = utils.generate_contact_reply(str(self.conversation.pk), trigger_message=str(user_message.pk))

        self.assertEqual(reply.sender, Message.Sender.CONTACT)
        self.assertEqual(reply.body, "Thanks for the update!")
        ask_mock.assert_called_once()

    def test_generate_contact_reply_falls_back_when_no_user_message(self) -> None:
        reply = utils.generate_contact_reply(str(self.conversation.pk))

        self.assertEqual(reply.sender, Message.Sender.CONTACT)
        self.assertIn("I'm here", reply.body)
