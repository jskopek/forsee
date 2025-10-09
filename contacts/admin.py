from django.contrib import admin

from .models import Contact


@admin.register(Contact)
class ContactAdmin(admin.ModelAdmin):
    list_display = ("name", "relationship", "user", "updated_at")
    list_filter = ("relationship", "user")
    search_fields = (
        "name",
        "relationship",
        "interests",
        "personality",
        "notes",
        "user__email",
    )
    ordering = ("name",)
