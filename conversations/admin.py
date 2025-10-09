from django.contrib import admin

from .models import Conversation, Message


@admin.register(Conversation)
class ConversationAdmin(admin.ModelAdmin):
    list_display = ("id", "owner", "contact", "title", "created_at")
    list_filter = ("owner", "contact")
    search_fields = ("title", "contact__name", "owner__email")
    ordering = ("-created_at",)


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ("id", "conversation", "sender", "short_body", "created_at")
    list_filter = ("sender", "conversation__owner")
    search_fields = ("body",)
    ordering = ("created_at",)

    @admin.display(description="body")
    def short_body(self, obj: Message) -> str:
        return obj.body[:60]
