package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

func verifySignature(rawBody []byte, provided, secret string) bool {
	if secret == "" || len(provided) != 64 {
		return false
	}
	got, err := hex.DecodeString(provided)
	if err != nil || len(got) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(rawBody)
	return hmac.Equal(got, mac.Sum(nil))
}
