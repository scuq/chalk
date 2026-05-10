package migrate

import (
	"strings"
	"testing"
	"testing/fstest"
)

func TestStripTransactionWrappers(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "no wrappers",
			in:   "CREATE TABLE foo (id int);",
			want: "CREATE TABLE foo (id int);",
		},
		{
			name: "begin and commit stripped",
			in:   "BEGIN;\nCREATE TABLE foo (id int);\nCOMMIT;",
			want: "\nCREATE TABLE foo (id int);\n",
		},
		{
			name: "lowercase",
			in:   "begin;\nCREATE TABLE foo (id int);\ncommit;",
			want: "\nCREATE TABLE foo (id int);\n",
		},
		{
			name: "begin with whitespace",
			in:   "  BEGIN  ;  \nCREATE TABLE foo (id int);\n  COMMIT  ;  ",
			want: "\nCREATE TABLE foo (id int);\n",
		},
		{
			name: "begin and statement on same line -- left alone",
			// "BEGIN; CREATE..." is unusual but valid SQL; we must not
			// mistake the BEGIN for a wrapper and zap the whole line.
			in:   "BEGIN; CREATE TABLE foo (id int);\nCOMMIT;",
			want: "BEGIN; CREATE TABLE foo (id int);\nCOMMIT;",
		},
		{
			name: "stacked semicolons",
			in:   "BEGIN;;\nCREATE TABLE foo (id int);\nCOMMIT;;",
			want: "\nCREATE TABLE foo (id int);\n",
		},
		{
			name: "no commit -- left alone",
			in:   "BEGIN;\nCREATE TABLE foo (id int);",
			want: "BEGIN;\nCREATE TABLE foo (id int);",
		},
		{
			name: "commit before begin -- left alone",
			in:   "COMMIT;\nBEGIN;\nCREATE TABLE foo (id int);",
			want: "COMMIT;\nBEGIN;\nCREATE TABLE foo (id int);",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stripTransactionWrappers(tt.in)
			if got != tt.want {
				t.Errorf("got:\n%q\nwant:\n%q", got, tt.want)
			}
		})
	}
}

func TestLoadOrdersByPrefix(t *testing.T) {
	fsys := fstest.MapFS{
		"m/0010_b.sql": {Data: []byte("-- 10")},
		"m/0001_a.sql": {Data: []byte("-- 1")},
		"m/0002_c.sql": {Data: []byte("-- 2")},
		"m/README.md":  {Data: []byte("ignored")},
		"m/.gitkeep":   {Data: []byte("ignored")},
		"m/notes.txt":  {Data: []byte("ignored")},
	}
	got, err := Load(fsys, "m")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3, got %d", len(got))
	}
	want := []string{"0001", "0002", "0010"}
	for i, g := range got {
		if g.Version != want[i] {
			t.Errorf("[%d] version=%q want=%q", i, g.Version, want[i])
		}
	}
}

func TestLoadRejectsNonNumericPrefix(t *testing.T) {
	fsys := fstest.MapFS{
		"m/0001_ok.sql":   {Data: []byte("-- 1")},
		"m/draft_xyz.sql": {Data: []byte("-- bad")},
	}
	_, err := Load(fsys, "m")
	if err == nil {
		t.Fatal("expected error for non-numeric prefix")
	}
	if !strings.Contains(err.Error(), "numeric") {
		t.Fatalf("expected numeric-prefix error, got: %v", err)
	}
}

func TestLoadRejectsDuplicateVersions(t *testing.T) {
	fsys := fstest.MapFS{
		"m/0001_a.sql": {Data: []byte("-- 1")},
		"m/0001_b.sql": {Data: []byte("-- 1 again")},
	}
	_, err := Load(fsys, "m")
	if err == nil {
		t.Fatal("expected error for duplicate versions")
	}
	if !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("expected duplicate error, got: %v", err)
	}
}
