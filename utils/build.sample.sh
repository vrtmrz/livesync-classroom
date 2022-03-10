#!/bin/sh
rm -rf ../hugo/content/**
obsdconv -src ../export -dst ../hugo/content -remapPathPrefix='static/>/static/' -cptag -title -link -cmmt -rmh1 -strictref
cd hugo
hugo -D