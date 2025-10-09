from django.urls import path

from . import views

app_name = "conversations"

urlpatterns = [
    path("", views.ConversationListView.as_view(), name="list"),
    path("new/", views.ConversationCreateView.as_view(), name="create"),
    path(
        "with-contact/<uuid:contact_pk>/start/",
        views.ConversationQuickStartView.as_view(),
        name="quick-start",
    ),
    path("<uuid:pk>/", views.ConversationDetailView.as_view(), name="detail"),
    path(
        "<uuid:pk>/partials/messages/",
        views.ConversationMessagesPartialView.as_view(),
        name="messages-partial",
    ),
    path(
        "<uuid:pk>/messages/send/",
        views.ConversationMessageCreateView.as_view(),
        name="message-send",
    ),
]
