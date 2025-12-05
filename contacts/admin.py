from django.contrib import admin

from .models import Contact


@admin.register(Contact)
class ContactAdmin(admin.ModelAdmin):
    list_display = ("name", "relationship", "updated_at")
    list_filter = ("relationship",)
    search_fields = (
        "name",
        "relationship",
        "interests",
        "personality",
        "notes",
    )
    ordering = ("name",)
