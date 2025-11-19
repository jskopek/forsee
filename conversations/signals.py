import pusher
from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver
import logging
from .models import Message

logger = logging.getLogger(__name__)


def get_pusher_client():
    """Get Pusher client instance."""
    app_id = settings.PUSHER_APP_ID
    key = settings.PUSHER_KEY
    secret = settings.PUSHER_SECRET
    cluster = settings.PUSHER_CLUSTER
    
    # Use print for immediate visibility in console
    print(f"[Pusher] Configuration check:")
    print(f"[Pusher]   APP_ID: {'SET' if app_id else 'NOT SET'} (value: {repr(app_id)})")
    print(f"[Pusher]   KEY: {'SET' if key else 'NOT SET'} (value: {repr(key)})")
    print(f"[Pusher]   SECRET: {'SET' if secret else 'NOT SET'} (value: {'***' if secret else 'None'})")
    print(f"[Pusher]   CLUSTER: {repr(cluster)}")
    
    logger.info(f"[Pusher] Configuration check:")
    logger.info(f"[Pusher]   APP_ID: {'SET' if app_id else 'NOT SET'} ({repr(app_id)})")
    logger.info(f"[Pusher]   KEY: {'SET' if key else 'NOT SET'} ({repr(key)})")
    logger.info(f"[Pusher]   SECRET: {'SET' if secret else 'NOT SET'}")
    logger.info(f"[Pusher]   CLUSTER: {repr(cluster)}")
    
    if not all([app_id, key, secret]):
        print("[Pusher] ⚠️ Missing required configuration. Pusher events will not be published.")
        logger.warning("[Pusher] Missing required configuration. Pusher events will not be published.")
        return None
    
    # Validate app_id is not empty string
    if not app_id or not app_id.strip():
        print(f"[Pusher] ⚠️ APP_ID is empty or whitespace: {repr(app_id)}")
        logger.warning(f"[Pusher] APP_ID is empty or whitespace: {repr(app_id)}")
        return None
    
    # Check if app_id looks like a key (long alphanumeric) instead of an app_id (usually numeric)
    if len(app_id) > 10 and app_id == key:
        print(f"[Pusher] ⚠️ ERROR: APP_ID appears to be set to the KEY value!")
        print(f"[Pusher]   APP_ID should be a number like '2074516'")
        print(f"[Pusher]   KEY should be a long string like 'a18a936dfd697b18aed1'")
        print(f"[Pusher]   Check your .env file - PUSHER_APP_ID and PUSHER_KEY may be swapped")
        logger.error("[Pusher] APP_ID appears to be set to KEY value - check .env file")
        return None
    
    try:
        print(f"[Pusher] Attempting to initialize client with app_id: {repr(app_id)}")
        client = pusher.Pusher(
            app_id=app_id,
            key=key,
            secret=secret,
            cluster=cluster,
            ssl=True
        )
        print("[Pusher] ✅ Client initialized successfully")
        logger.info("[Pusher] Client initialized successfully")
        return client
    except Exception as e:
        print(f"[Pusher] ❌ Failed to initialize client: {e}")
        print(f"[Pusher]   app_id type: {type(app_id)}, value: {repr(app_id)}")
        logger.error(f"[Pusher] Failed to initialize client: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return None


@receiver(post_save, sender=Message)
def notify_message_added(sender, instance, created, **kwargs):
    """Publish Pusher event when a new message is added."""
    if not created:
        return
    
    # Wrap everything in try/except so Pusher errors don't crash the request
    try:
        logger.info(f"[Pusher] Message created: {instance.id} in conversation {instance.conversation_id}")
        
        pusher_client = get_pusher_client()
        if not pusher_client:
            logger.warning("[Pusher] No Pusher client available, skipping event publish")
            return
        
        channel_name = f'conversation-{instance.conversation_id}'
        event_data = {
            'conversation_id': str(instance.conversation_id),
            'message_id': str(instance.id),
        }
        logger.info(f"[Pusher] Publishing to channel: {channel_name}, event: message_added, data: {event_data}")
        
        pusher_client.trigger(
            channel_name,
            'message_added',
            event_data
        )
        logger.info(f"[Pusher] ✅ Event published successfully")
    except Exception as e:
        # Don't crash the request if Pusher fails
        logger.error(f"[Pusher] ❌ Error in notify_message_added: {e}")
        import traceback
        logger.error(traceback.format_exc())

