package main

import (
	"os"
	"strings"
	"testing"
)

func TestBuildProdTracksFrontendInputs(t *testing.T) {
	content, err := os.ReadFile("../../moon.yml")
	if err != nil {
		t.Fatalf("read moon.yml: %v", err)
	}
	text := string(content)
	buildProdIdx := strings.Index(text, "  build-prod:")
	if buildProdIdx < 0 {
		t.Fatal("moon.yml must define gmuxd:build-prod")
	}
	buildProd := text[buildProdIdx:]
	installIdx := strings.Index(buildProd, "  install:")
	if installIdx >= 0 {
		buildProd = buildProd[:installIdx]
	}

	requiredInputs := []string{
		"/apps/gmux-web/src/**/*",
		"/apps/gmux-web/public/**/*",
		"/apps/gmux-web/index.html",
		"/apps/gmux-web/package.json",
		"/apps/gmux-web/vite.config.ts",
		"/apps/gmux-web/tsconfig.json",
		"/pnpm-lock.yaml",
	}
	for _, input := range requiredInputs {
		if !strings.Contains(buildProd, input) {
			t.Fatalf("gmuxd:build-prod inputs must include %s so prod embeds fresh frontend assets", input)
		}
	}
}
