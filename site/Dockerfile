# Static site: nginx serves the directory as-is (index.html, docs.html, assets).
FROM nginx:alpine
# ponytail: pull fixed alpine packages so Girder's CRITICAL scan gate passes
# between nginx:alpine image refreshes.
RUN apk upgrade --no-cache
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
RUN rm -f /usr/share/nginx/html/nginx.conf /usr/share/nginx/html/Dockerfile
