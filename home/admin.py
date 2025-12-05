from django.contrib import admin

from .models import PatientProfile


@admin.register(PatientProfile)
class PatientProfileAdmin(admin.ModelAdmin):
    list_display = ("full_name", "location", "updated_at")
    search_fields = ("full_name", "location", "medical_condition", "interests", "sports_teams")
