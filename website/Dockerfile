# The Forsee website: static files served by nginx. Deployed with Dokploy
# (build context: website/). See docs/RELEASING.md.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
