from django.contrib import admin

from .models import Contact


@admin.register(Contact)
class ContactAdmin(admin.ModelAdmin):
    list_display = ("name", "relationship", "user")
    list_filter = ("relationship",)
    search_fields = ("name", "relationship", "notes", "user__email")
