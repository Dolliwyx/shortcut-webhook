# syntax=docker/dockerfile:1
FROM golang:1.27.1-bookworm AS build
WORKDIR /app
COPY go.mod ./
COPY *.go ./
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /relay .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /relay /relay
EXPOSE 3000
ENTRYPOINT ["/relay"]
