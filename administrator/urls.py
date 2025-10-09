from django.urls import path

from . import views

app_name = "administrator"

urlpatterns = [
    path("", views.DashboardView.as_view(), name="dashboard"),
    path("users/<int:pk>/", views.UserDetailView.as_view(), name="user-detail"),
    path("users/<int:pk>/edit/", views.UserUpdateView.as_view(), name="user-edit"),
    path("users/<int:pk>/delete/", views.UserDeleteView.as_view(), name="user-delete"),
    path(
        "users/<int:pk>/generate-contact/",
        views.GenerateContactView.as_view(),
        name="user-generate-contact",
    ),
    path("users/generate/", views.GenerateUsersView.as_view(), name="generate-users"),
]
