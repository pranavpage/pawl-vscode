package main

import (
	"fmt"
	"strconv"
	"strings"
)

type Alarm struct {
	Machine  string
	Severity int
	Message  string
}

// parseLine splits "machine,severity,message" into an Alarm. The message may hold commas.
func parseLine(line string) (Alarm, error) {
	<|>
}

func main() {
	a, err := parseLine("press-4,3,oil low, check pump")
	fmt.Println(a, err, strings.ToUpper(a.Machine), strconv.Itoa(a.Severity))
}
