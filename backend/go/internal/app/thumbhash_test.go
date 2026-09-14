package app

import (
	"encoding/hex"
	"testing"
)

func TestRGBAToThumbHashMatchesNodePackageFixtures(t *testing.T) {
	cases := []struct {
		name string
		w    int
		h    int
		rgba []byte
		want string
	}{
		{
			name: "red1",
			w:    1,
			h:    1,
			rgba: []byte{255, 0, 0, 255},
			want: "d5fb2b077f08f708888788708f7088f80888808008088800",
		},
		{
			name: "redblue2x1",
			w:    2,
			h:    1,
			rgba: []byte{255, 0, 0, 255, 0, 0, 255, 255},
			want: "15f62a0cc17808878888878078878f88db8808",
		},
		{
			name: "whiteblack1x2",
			w:    1,
			h:    2,
			rgba: []byte{255, 255, 255, 255, 0, 0, 0, 255},
			want: "200842040008d7288778820d27780000000000",
		},
		{
			name: "alpha2x2",
			w:    2,
			h:    2,
			rgba: []byte{
				255, 0, 0, 255,
				0, 255, 0, 128,
				0, 0, 255, 64,
				0, 0, 0, 0,
			},
			want: "158aaa3d1c777808888887880875bff8887d8a058b78884807",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := rgbaToThumbHash(tc.w, tc.h, tc.rgba)
			if err != nil {
				t.Fatal(err)
			}
			if hex.EncodeToString(got) != tc.want {
				t.Fatalf("thumbhash = %s, want %s", hex.EncodeToString(got), tc.want)
			}
		})
	}
}

func TestParsePAMRGBA(t *testing.T) {
	image, err := parsePAMRGBA([]byte("P7\nWIDTH 2\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n\x01\x02\x03\x04\x05\x06\x07\x08"))
	if err != nil {
		t.Fatal(err)
	}
	if image.Width != 2 || image.Height != 1 {
		t.Fatalf("dimensions = %dx%d", image.Width, image.Height)
	}
	if hex.EncodeToString(image.RGBA) != "0102030405060708" {
		t.Fatalf("rgba = %x", image.RGBA)
	}
}
