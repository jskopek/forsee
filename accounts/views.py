from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render


@login_required
def dashboard(request):
    if request.user.is_superuser:
        return redirect("administrator:dashboard")
    recent_contacts = request.user.contacts.order_by("-created_at")[:3]
    recent_conversations = (
        request.user.conversations.select_related("contact")
        .order_by("-updated_at")
        [:3]
    )
    context = {
        "user_profile": request.user,
        "recent_contacts": recent_contacts,
        "recent_conversations": recent_conversations,
    }
    return render(request, "accounts/dashboard.html", context)
