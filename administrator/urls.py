from django.urls import path

from . import views

app_name = "administrator"

urlpatterns = [
    path("", views.DashboardView.as_view(), name="dashboard"),
    path("users/<int:pk>/edit/", views.UserUpdateView.as_view(), name="user-edit"),
    path("users/<int:pk>/delete/", views.UserDeleteView.as_view(), name="user-delete"),
]
