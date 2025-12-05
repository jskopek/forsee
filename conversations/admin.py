from django.contrib import admin

from .models import Conversation, Message


@admin.register(Conversation)
class ConversationAdmin(admin.ModelAdmin):
    list_display = ("id", "title", "created_at")
    search_fields = ("title",)
    ordering = ("-created_at",)


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ("id", "conversation", "sender", "short_body", "created_at")
    list_filter = ("sender",)
    search_fields = ("body",)
    ordering = ("created_at",)

    @admin.display(description="body")
    def short_body(self, obj: Message) -> str:
        return obj.body[:60]
