package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	name := strings.TrimSpace(os.Getenv("USER"))
	if name == "" {
		fmt.Fprintln(os.Stderr, "USER is not set")
		os.Exit(1)
	}
	fmt.Printf("hello, %s<|>
}
