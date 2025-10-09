from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import User


class CustomUserAdmin(UserAdmin):
    model = User
    list_display = ("full_name", "email", "location", "is_staff", "is_active")
    list_filter = ("is_staff", "is_active")
    fieldsets = (
        (None, {"fields": ("email", "full_name", "password")}),
        (
            "Profile",
            {
                "fields": (
                    "location",
                    "medical_condition",
                    "interests",
                    "sports_teams",
                )
            },
        ),
        ("Permissions", {"fields": ("is_staff", "is_active", "groups", "user_permissions")}),
    )
    add_fieldsets = (
        (None, {
            "classes": ("wide",),
            "fields": (
                "email",
                "full_name",
                "password1",
                "password2",
                "location",
                "medical_condition",
                "interests",
                "sports_teams",
                "is_staff",
                "is_active",
                "groups",
                "user_permissions",
            )}
        ),
    )
    search_fields = ("email", "full_name", "location", "interests", "sports_teams")
    ordering = ("email",)


admin.site.register(User, CustomUserAdmin)
