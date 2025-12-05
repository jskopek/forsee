from django.urls import path

from . import views

app_name = "conversations"

urlpatterns = [
    path("", views.ConversationListView.as_view(), name="list"),
    path("new/", views.ConversationCreateView.as_view(), name="create"),
    path("<uuid:pk>/", views.ConversationDetailView.as_view(), name="detail"),
    path("<uuid:pk>/keyboard/", views.ConversationKeyboardView.as_view(), name="keyboard"),
]
