from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render

from conversations.models import Conversation


@login_required
def dashboard(request):
    if request.user.is_superuser:
        return redirect("administrator:dashboard")
    recent_conversations = Conversation.objects.order_by("-updated_at", "-created_at")[:5]
    context = {
        "user_profile": request.user,
        "recent_conversations": recent_conversations,
    }
    return render(request, "accounts/dashboard.html", context)
