from django.contrib.auth.models import AbstractBaseUser, PermissionsMixin
from django.db import models
from django.forms.models import model_to_dict
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from .managers import UserManager


class User(AbstractBaseUser, PermissionsMixin):
    email = models.EmailField(_("email address"), unique=True)
    full_name = models.CharField(max_length=255, blank=True)
    is_staff = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    date_joined = models.DateTimeField(default=timezone.now)
    location = models.CharField(max_length=255, blank=True)
    medical_condition = models.TextField(blank=True)
    interests = models.TextField(blank=True)
    sports_teams = models.TextField(blank=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    objects = UserManager()

    def __str__(self):
        return self.full_name or self.email

    @property
    def profile_data(self) -> dict:
        return model_to_dict(
            self,
            fields=["id", "email", "full_name", "location", "medical_condition", "interests", "sports_teams"],
        )
