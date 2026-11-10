package main

// PLAN
// [x] read lines from stdin
// [ ] count how often each word appears, ignoring case
// [ ] print the ten most common words with their counts
// END PLAN

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	var lines []string
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	<|>
	fmt.Println(len(lines))
}
