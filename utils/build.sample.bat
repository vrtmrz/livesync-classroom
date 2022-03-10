cd %~dp0
for /D %%1 in (..\hugo\content) do rmdir /s /q "%%1"
obsdconv -src ../export -dst ../hugo/content -remapPathPrefix="static/>/static/" -cptag -title -link -cmmt -rmh1 -strictref
cd hugo
hugo -D