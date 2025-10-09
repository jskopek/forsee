from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render


@login_required
def dashboard(request):
    if request.user.is_superuser:
        return redirect("administrator:dashboard")
    return render(request, "accounts/dashboard.html", {"user_profile": request.user})
