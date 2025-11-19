web: gunicorn app.wsgi --log-file -
worker: python manage.py rqworker default
release: python manage.py migrate
